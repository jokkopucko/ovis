const korean = /^ko\b/i.test(navigator.language ?? "");
if (korean) {
  document.documentElement.lang = "ko";
  for (const element of document.querySelectorAll("[data-ko]")) element.textContent = element.dataset.ko;
}
const text = (en, ko) => (korean ? ko : en);
const words = {
  pending: text("Starting…", "시작하는 중…"),
  waiting: "",
  ok: text("Running", "실행 중"),
  failed: text("Failed", "실패"),
  stopped: text("Stopped", "멈춤"),
};
const desktop = window.ovisDesktop;

function show(status) {
  const server = status.core === "ok" ? status.server : "waiting";
  document.getElementById("core").dataset.state = status.core;
  document.getElementById("core-state").textContent = words[status.core];
  document.getElementById("server").dataset.state = server;
  document.getElementById("server-state").textContent = words[server];
  document.getElementById("hc-version").textContent = status.versions ? `herdr-core ${status.versions.hc}` : "";
  const failed = status.core === "failed" || status.server === "failed" || status.server === "stopped";
  document.getElementById("title").textContent = failed
    ? (status.server === "stopped" ? text("Ovis stopped", "Ovis가 멈췄습니다") : text("Ovis could not start", "Ovis를 시작하지 못했습니다"))
    : status.server === "ok" ? text("Opening Ovis…", "Ovis를 여는 중…") : text("Starting Ovis…", "Ovis를 시작하는 중…");
  const detail = document.getElementById("detail");
  detail.textContent = status.detail;
  detail.hidden = !failed || status.detail === "";
  document.getElementById("retry").hidden = !failed;
}

/** the update the app has downloaded (main.ts UpdateLine), or null: shown here even when its line was closed in Ovis */
function showUpdate(update) {
  document.getElementById("update").hidden = update === null;
  if (update === null) return;
  document.getElementById("update-text").textContent = update.text;
  document.getElementById("update-install").textContent = update.action;
}

document.getElementById("retry").addEventListener("click", () => desktop.retry());
document.getElementById("logs").addEventListener("click", () => desktop.showLogs());
desktop.onStatus(show);
void desktop.status().then(show);

const install = document.getElementById("update-install");
install.addEventListener("click", () => {
  // answered only when Ovis keeps running (a .deb's password prompt cancelled): then it may be pressed again
  install.disabled = true;
  const again = () => { install.disabled = false; };
  window.ovisUpdate.install().then(again, again);
});
// the app may tell of a download before its answer to the asking arrives: that answer was read before it, and is dropped
let updateTold = false;
window.ovisUpdate.onChange((update) => {
  updateTold = true;
  showUpdate(update);
});
void window.ovisUpdate.current().then((update) => {
  if (!updateTold) showUpdate(update);
});
