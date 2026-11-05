// The connect screen: the app's first page until a PC is chosen. Opening a PC goes through the
// native HerdrShell plugin, which makes the PC's address the WebView's first page: navigating
// there from this page would cost every launch about 1.5 s (docs/native-app.md, Spike results).
import { APP_ORIGIN, localize, parseAddress, publicHttp, relayLink, shell, t } from "./shell.js";

localize();

// only iOS opens a plain http PC slower (docs/native-app.md, The app); Android shows no such delay
if (window.Capacitor?.getPlatform?.() !== "ios") document.querySelector(".hint")?.remove();

const form = document.getElementById("connect");
const input = document.getElementById("address");
const error = document.getElementById("error");
/** PCs that loaded before (an origin, or a relay PC's scope), and the public http address the user was just warned about. */
let savedOrigins = [];
let warned = "";

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
  const url = parseAddress(text);
  if (url === null) { error.textContent = t("That is not an http or https address.", "http 또는 https 주소가 아닙니다."); input.focus(); return; }
  // a PC paired over the Ovis relay opens at its scope on the app's origin, saved under that scope
  const relay = relayLink(url);
  if (relay?.error) { error.textContent = relayErrors[relay.error](); input.focus(); return; }
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
  error.textContent = "";
  try { await shell("open", { url: url.href }); }
  catch (err) { error.textContent = String(err?.message ?? err); }
}

form.addEventListener("submit", (event) => { event.preventDefault(); void open(input.value); });

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

function renderSaved(saved, current, names) {
  const list = document.getElementById("saved");
  list.replaceChildren();
  for (const origin of saved) {
    const item = document.createElement("li");
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "open";
    const label = names[origin] ? `${names[origin]} (${new URL(origin).host})` : origin;
    openButton.textContent = origin === current ? `${label} ${t("(last opened)", "(마지막으로 연 PC)")}` : label;
    openButton.addEventListener("click", () => void open(origin));
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "forget";
    forget.textContent = t("Forget", "지우기");
    forget.setAttribute("aria-label", t(`Forget ${label}`, `${label} 지우기`));
    forget.addEventListener("click", async () => { await shell("forget", { url: origin }); await load(); });
    item.append(openButton, forget);
    list.append(item);
  }
  document.getElementById("saved-section").hidden = saved.length === 0;
}

async function load() {
  const state = await shell("getState");
  savedOrigins = state.saved ?? [];
  renderSaved(savedOrigins, state.last ?? "", state.names ?? {});
}

void load();
