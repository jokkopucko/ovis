// The connect screen: the app's first page until a PC is chosen. Opening a PC goes through the
// native HerdrShell plugin, which makes the PC's address the WebView's first page: navigating
// there from this page would cost every launch about 1.5 s (docs/native-app.md, Spike results).
import { ACCOUNT_SERVICE, ACCOUNT_SIGN_IN, APP_ORIGIN, barsForScreen, followScheme, listedProviders, localize, openFailure, parseAddress, publicHttp, relayLink, shell, sshDetails, t } from "./shell.js";

localize();
followScheme();

const feedback = document.getElementById("feedback");
const form = document.getElementById("connect");
const input = document.getElementById("address");
const error = document.getElementById("error");
const spinner = document.getElementById("spinner");
const statusText = document.getElementById("status-text");
const cancel = document.getElementById("cancel");
const android = window.Capacitor?.getPlatform?.() === "android";
let attempt = 0;
let pending = false;

/**
 * Shows what opens, or nothing. The status text is a live region that stays in the page, empty when
 * nothing opens: one that appeared together with its text would not be announced.
 */
function showStatus(text) {
  pending = text !== "";
  statusText.textContent = text;
  spinner.hidden = !pending;
  cancel.hidden = !pending;
}

function stopPending() {
  if (!pending) return;
  attempt++;
  showStatus("");
  barsForScreen();
  if (android) void shell("cancelOpen");
}
/** PCs that loaded before (an origin, or a relay PC's scope), and the public http address the user was just warned about. */
let savedOrigins = [];
let warned = "";
/** The PCs added over SSH (Android's OvisSsh plugin), by their loopback origin on this phone. */
let sshPcs = {};

/** Calls Android's OvisSsh plugin (app/android/.../OvisSshPlugin.java). */
function ssh(method, options = {}) {
  return window.Capacitor.nativePromise("OvisSsh", method, options);
}

const appHost = new URL(APP_ORIGIN).host;
const relayErrors = {
  "foreign-offer": () => t(
    `This pairing link is not on the Ovis app's address (${appHost}), so the app does not open it. Scan the QR code your PC shows.`,
    `이 페어링 링크는 Ovis 앱 주소(${appHost})가 아니어서 열지 않습니다. PC에 표시된 QR 코드를 스캔하세요.`,
  ),
  "bad-offer": () => t(
    "This pairing link is damaged or names another PC. Show the QR code on your PC again and scan it.",
    "이 페어링 링크가 손상되었거나 다른 PC를 가리킵니다. PC에서 QR 코드를 다시 띄워 스캔하세요.",
  ),
  "not-a-pc": () => t(
    `That is a page of the Ovis app (${appHost}), not a PC. Scan the QR code your PC shows.`,
    `Ovis 앱(${appHost})의 페이지이지 PC가 아닙니다. PC에 표시된 QR 코드를 스캔하세요.`,
  ),
};

async function open(text) {
  stopPending();
  // the bundled demo (build-web.ts), for a store review without a PC: the address "demo" opens it, with no button for it
  if (String(text).trim().toLowerCase() === "demo") { location.href = "demo/index.html"; return; }
  // an SSH PC whose host key was forgotten on purpose opens only through the setup screen, which shows the key to confirm
  const url = parseAddress(text);
  // looked up by origin, as each is saved, so the address typed with a path or a trailing slash finds it too
  const sshPc = url === null ? undefined : sshPcs[url.origin];
  if (sshPc && !sshDetails(sshPc).confirmed) {
    error.textContent = "";
    try { await ssh("setUp", { origin: sshPc.origin }); }
    catch (err) { error.textContent = String(err?.message ?? err); }
    return;
  }
  if (url === null) { error.textContent = t("That is not an http or https address.", "http 또는 https 주소가 아닙니다."); if (!addressScreen.hidden) input.focus(); return; }
  // the hosted app itself, saved once it loaded (a sign-in opens it): picked from this list, it opens on its front page
  // (#pcs, which the hosted app takes as the app's own way there: Add a PC, or its sign-in), not straight into the PC it
  // opened last as a launch does (src/lib/relay/shell.tsx, launchOrder): a new web view starts a new session, so a bare
  // address would count as a launch and loop back to the PC just left
  if (url.origin === new URL(APP_ORIGIN).origin && url.pathname === "/" && url.hash === "") {
    error.textContent = "";
    try { await shell("open", { url: `${APP_ORIGIN}/#pcs`, name: "Ovis" }); }
    catch (err) { error.textContent = String(err?.message ?? err); }
    return;
  }
  // a PC paired over the Ovis relay opens at its scope on the app's origin, saved under that scope
  const relay = relayLink(url);
  if (relay?.error) { error.textContent = relayErrors[relay.error](); if (!addressScreen.hidden) input.focus(); return; }
  if (relay) {
    error.textContent = "";
    try { await shell("open", { url: relay.url, scope: relay.scope, ...(relay.name ? { name: relay.name } : {}) }); }
    catch (err) { error.textContent = String(err?.message ?? err); }
    return;
  }
  if (publicHttp(url) && !savedOrigins.some((saved) => new URL(saved).origin === url.origin) && warned !== url.href) {
    warned = url.href;
    error.textContent = t(
      `${url.host} is not on a tailnet or a home network, so plain http would send the pairing code and everything you type across the internet unencrypted. Use its https address, or open it again to go ahead.`,
      `${url.host}은(는) tailnet이나 집 네트워크의 주소가 아니어서, 일반 http로는 페어링 코드와 입력하는 모든 내용이 암호화되지 않은 채 인터넷으로 오갑니다. https 주소를 쓰거나, 그래도 열려면 한 번 더 여세요.`,
    );
    return;
  }
  // the Android app first asks the address whether it is Ovis (PCStore.check), for up to 20 s:
  // until it answers the screen says what it opens, with Cancel. The iOS app opens it at once.
  error.textContent = "";
  const mine = ++attempt;
  showStatus(t(`Opening ${url.host}…`, `${url.host} 여는 중…`));
  try { await shell("open", { url: url.href, check: true }); }
  catch (err) { if (mine === attempt) error.textContent = openFailure(url, err?.code, String(err?.message ?? err)); }
  finally { if (mine === attempt) showStatus(""); }
}

const screens = { "sign-in": document.getElementById("sign-in"), add: document.getElementById("add"), address: document.getElementById("address-screen") };
const addressScreen = screens.address;
// a build without the account (OVIS_APP_ACCOUNT=0, build-web.ts) starts on Add a PC, with nothing to go back to
const first = ACCOUNT_SIGN_IN ? "sign-in" : "add";

/**
 * One screen at a time; what an open says goes with the screen that is up, above the PCs opened before so a long list
 * never pushes it out of sight. `focus`: what gets the focus on it, none for false.
 */
function show(name, focus) {
  stopPending();
  error.textContent = "";
  for (const [key, screen] of Object.entries(screens)) screen.hidden = key !== name;
  screens[name].insertBefore(feedback, screens[name].querySelector("#saved-section"));
  if (focus !== false) (focus ?? screens[name].querySelector("button:not([hidden])"))?.focus();
}

/**
 * A step forward is an entry of the page's history, so the phone's own Back steps back as the round Back does (Android
 * gives Back to a page with history of the app's own, MainActivity.syncBack).
 */
function go(name, focus) {
  history.pushState({ screen: name }, "", `#${name}`);
  show(name, focus);
}

history.replaceState({ screen: first }, "", location.pathname);
addEventListener("popstate", (event) => { show(screens[event.state?.screen] ? event.state.screen : first); });
for (const screen of [screens.add, screens.address]) screen.querySelector("[data-back]").addEventListener("click", () => history.back());
document.getElementById("no-account").addEventListener("click", () => go("add"));
document.getElementById("address-way").addEventListener("click", () => go("address", input));

// a machine reached over SSH from this phone: Android's OvisSsh plugin asks the rest on a screen of its own. An app
// without it (iOS, or an Android build before it) has no SSH to offer, so the way is left out rather than drawn dead
const sshWay = document.getElementById("ssh-way");
// the plugins the app announces to the page before its first script runs (src/lib/nativeApp.ts, hasNativePlugin)
if ((window.Capacitor?.PluginHeaders ?? []).some((header) => header.name === "OvisSsh")) sshWay.addEventListener("click", async () => {
  // an open still being checked must not take over while the setup screen is up
  stopPending();
  error.textContent = "";
  try { await ssh("add"); }
  catch (err) { error.textContent = String(err?.message ?? err); }
});
else sshWay.hidden = true;

cancel.addEventListener("click", () => {
  stopPending();
  if (!addressScreen.hidden) input.focus();
});

form.addEventListener("submit", (event) => { event.preventDefault(); void open(input.value); });

const account = document.getElementById("account");
/** Draws a button for each sign-in named, in the build's order. */
function showProviders(providers) {
  for (const button of account.querySelectorAll("[data-provider]")) button.hidden = !providers.includes(button.dataset.provider);
}

if (!ACCOUNT_SIGN_IN) {
  screens.add.querySelector("[data-back]").hidden = true;
  show("add", false);
}
else {
  show("sign-in", false);
  // the service names its sign-ins (GET /v1/providers), as the hosted app reads them; until it answers, GitHub alone
  // (the markup's), the hosted app's own fallback, so no button opens a sign-in the hosted app would not start
  fetch(new URL("/v1/providers", ACCOUNT_SERVICE)).then((response) => response.ok ? response.json() : null).then((body) => {
    const listed = listedProviders(body);
    if (listed !== null) showProviders(listed);
  }, () => undefined);
  // the sign-in itself runs on the hosted app, which this opens on that provider's sign-in (#sign-in=, boot.ts). One
  // press at a time, and none after one that went (Android answers before the page is replaced): a second open would
  // race the first for the page the app keeps
  const buttons = [...account.querySelectorAll("[data-provider]")];
  for (const button of buttons) button.addEventListener("click", async () => {
    error.textContent = "";
    for (const each of buttons) each.disabled = true;
    try { await shell("open", { url: `${APP_ORIGIN}/#sign-in=${button.dataset.provider}`, name: "Ovis" }); }
    catch (err) {
      error.textContent = String(err?.message ?? err);
      for (const each of buttons) each.disabled = false;
    }
  });
}

document.getElementById("scan").addEventListener("click", async () => {
  error.textContent = "";
  try {
    // the plugin's own JS fills these defaults; this page calls the bridge without it
    const result = await window.Capacitor.nativePromise("CapacitorBarcodeScanner", "scanBarcode", { hint: 0, scanInstructions: t("Point at the QR code under Settings → Phone & devices on your PC", "PC의 설정 → 폰 및 기기에 있는 QR 코드를 비추세요"), scanButton: false, scanText: " ", cameraDirection: 1, scanOrientation: 3 });
    if (result?.ScanResult) await open(result.ScanResult);
  } catch (err) {
    error.textContent = String(err?.message ?? err);
  }
});

function button(text, onClick, className = "") {
  const element = document.createElement("button");
  element.type = "button";
  if (className) element.className = className;
  element.textContent = text;
  element.addEventListener("click", onClick);
  return element;
}

function paragraph(text, className = "") {
  const element = document.createElement("p");
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

/**
 * Manage under an SSH PC in the list: what it is, and what can be done to it here. Each action says
 * what happened in the panel's own line, so nothing happens out of sight.
 */
function managePanel(origin, label) {
  const pc = sshPcs[origin];
  const details = sshDetails(pc);
  const panel = document.createElement("div");
  panel.className = "manage";
  panel.id = `manage-${origin.replace(/[^a-z0-9]/gi, "-")}`;
  const said = paragraph("", "said");
  said.setAttribute("role", "status");
  const say = (text) => { said.textContent = text; };
  const fail = (err) => { said.textContent = String(err?.message ?? err); };
  const actions = document.createElement("div");
  actions.className = "actions";
  const extra = document.createElement("div");

  const rename = button(t("Rename", "이름 바꾸기"), () => {
    const input = document.createElement("input");
    input.value = label;
    input.maxLength = 64;
    input.setAttribute("aria-label", t("Name in the list", "목록에 보일 이름"));
    const save = button(t("Save", "저장"), async () => {
      try { await ssh("rename", { origin, name: input.value }); await load(); }
      catch (err) { fail(err); }
    }, "primary");
    extra.replaceChildren(input, save);
    input.focus();
  });
  const phoneKey = button(t("Show this phone's key", "이 휴대폰의 키 보기"), async () => {
    try {
      const { line } = await ssh("phoneKey");
      const code = document.createElement("code");
      code.className = "key";
      code.textContent = line;
      const copy = button(t("Copy", "복사"), async () => { await ssh("copy", { text: line }); say(t("Copied.", "복사했습니다.")); });
      const share = button(t("Share", "공유"), async () => { await ssh("share", { text: line }); });
      extra.replaceChildren(paragraph(t("This phone signs in with this key. It goes in ~/.ssh/authorized_keys on the PC:", "이 휴대폰은 이 키로 로그인합니다. PC의 ~/.ssh/authorized_keys에 들어갑니다:")), code, copy, share);
    } catch (err) { fail(err); }
  });
  const setUp = button(t("Set up again", "다시 설정"), async () => {
    stopPending();
    try { await ssh("setUp", { origin }); }
    catch (err) { fail(err); }
  });
  const forgetKey = button(t("Forget host key", "호스트 키 지우기"), () => {
    const yes = button(t("Forget it", "지우기"), async () => {
      try { await ssh("forgetHostKey", { origin }); await load(); }
      catch (err) { fail(err); }
    }, "primary");
    extra.replaceChildren(paragraph(t(
      "Only when you know why the PC's SSH key changed (the machine was reinstalled, its keys replaced). Opening it then shows the key it has now, to check on the PC and confirm.",
      "PC의 SSH 키가 왜 바뀌었는지 알 때만 지우세요(기기를 다시 설치했거나 키를 바꾼 경우). 그 뒤 열면 지금의 키를 보여 주니, PC에서 확인하고 신뢰하세요.",
    )), yes);
  });
  const remove = button(t("Remove", "삭제"), () => {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `${panel.id}-clean`;
    box.checked = pc.auth === "phone-key";
    box.disabled = pc.auth !== "phone-key" || !details.confirmed;
    const boxLabel = document.createElement("label");
    boxLabel.className = "check";
    boxLabel.htmlFor = box.id;
    boxLabel.textContent = t("Also take this phone's key out of the PC's authorized_keys (the PC has to be reachable)", "PC의 authorized_keys에서도 이 휴대폰의 키를 빼기(PC에 닿아야 함)");
    boxLabel.prepend(box);
    const yes = button(t("Remove", "삭제"), async () => {
      try {
        const { remote, reason } = await ssh("remove", { origin, cleanRemote: box.checked });
        await load();
        if (remote === "failed") error.textContent = t(`${label} was removed from this phone, but its key could not be taken out of the PC (${reason}). Remove the line whose comment starts with ovis-phone: from ~/.ssh/authorized_keys there yourself.`, `${label}을(를) 이 휴대폰에서 지웠지만 PC에서 키를 빼지 못했습니다(${reason}). 그쪽 ~/.ssh/authorized_keys에서 주석이 ovis-phone:으로 시작하는 줄을 직접 지우세요.`);
      } catch (err) { fail(err); }
    }, "primary");
    extra.replaceChildren(paragraph(t(`Remove ${label} from this phone? Its host key and the key saved for it go too.`, `이 휴대폰에서 ${label}을(를) 지울까요? 호스트 키와 이 PC용으로 저장한 키도 함께 지워집니다.`)), boxLabel, yes);
  });
  actions.append(rename, phoneKey, setUp, ...(details.confirmed ? [forgetKey] : []), remove);
  panel.append(paragraph(details.address), paragraph(details.how), paragraph(details.hostKey, "key"), actions, extra, said);
  return panel;
}

function renderSaved(saved, current, names) {
  const list = document.getElementById("saved");
  list.replaceChildren();
  for (const origin of saved) {
    const item = document.createElement("li");
    const sshPc = sshPcs[origin];
    const label = names[origin] ? (sshPc ? names[origin] : `${names[origin]} (${new URL(origin).host})`) : (sshPc ? `${sshPc.label} (SSH)` : origin);
    const openButton = button(origin === current ? `${label} ${t("(last opened)", "(마지막으로 연 PC)")}` : label, () => void open(origin), "open");
    if (sshPc) {
      // an SSH PC is managed rather than only forgotten: its key and host key live on this phone
      const manage = button(t("Manage", "관리"), () => {
        const shown = item.nextElementSibling?.classList.contains("manage-row");
        if (shown) { item.nextElementSibling.remove(); manage.setAttribute("aria-expanded", "false"); return; }
        const row = document.createElement("li");
        row.className = "manage-row";
        row.append(managePanel(origin, label));
        item.after(row);
        manage.setAttribute("aria-expanded", "true");
      }, "forget");
      manage.setAttribute("aria-expanded", "false");
      manage.setAttribute("aria-label", t(`Manage ${label}`, `${label} 관리`));
      item.append(openButton, manage);
    } else {
      const forget = button(t("Forget", "지우기"), async () => { await shell("forget", { url: origin }); await load(); }, "forget");
      forget.setAttribute("aria-label", t(`Forget ${label}`, `${label} 지우기`));
      item.append(openButton, forget);
    }
    list.append(item);
  }
  document.getElementById("saved-section").hidden = saved.length === 0;
}

async function load() {
  const state = await shell("getState");
  savedOrigins = state.saved ?? [];
  sshPcs = {};
  if (android) {
    try { for (const pc of (await ssh("list")).pcs ?? []) sshPcs[pc.origin] = pc; }
    catch { /* an app without the plugin lists its PCs as before */ }
  }
  renderSaved(savedOrigins, state.last ?? "", state.names ?? {});
  // an SSH PC whose address on this phone another app took first is not opened (OvisSshPlugin.listen)
  if (state.kind === "ssh-port") {
    error.textContent = t(
      `Another app on this phone took the address the SSH PC opens on (${state.failure}), so the app did not open it: that app would have answered in its place. Close or uninstall the app you do not know, or restart the phone, then open the PC again.`,
      `이 휴대폰의 다른 앱이 SSH PC가 열리는 주소(${state.failure})를 먼저 차지해서 열지 않았습니다. 그 앱이 대신 응답할 수 있기 때문입니다. 모르는 앱을 닫거나 지우거나 휴대폰을 다시 시작한 뒤 PC를 다시 여세요.`,
    );
  }
}

void load();

// a PC's link on the app's origin tapped outside the app (a message, the camera reading the PC's QR
// code), which Android hands to the app (MainActivity's app link): opened as a scanned QR code is
async function openAppLink() {
  if (window.Capacitor?.getPlatform?.() !== "android") return;
  const { url } = await shell("takeLink");
  if (!url) return;
  go("address", false);
  input.value = url;
  await open(url);
}

void openAppLink();
