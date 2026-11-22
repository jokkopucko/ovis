(() => {
  const BETA_LINKS = {
    // iPhone: the public link of the "Ovis Beta" TestFlight group,
    // https://testflight.apple.com/join/…
    testflight: "https://testflight.apple.com/join/dCVKYRA3",
  };

  if (typeof module === "object" && module.exports) {
    module.exports = { BETA_LINKS };
    return;
  }

  for (const [key, link] of Object.entries(BETA_LINKS)) {
    if (!link) continue;
    for (const a of document.querySelectorAll(`a[data-beta-link="${key}"]`)) a.href = link;
    for (const section of document.querySelectorAll(`[data-beta="${key}"]`)) section.hidden = false;
  }

  const COPIED = { "zh-CN": ["已复制", "复制失败"], ja: ["コピーしました", "コピーできませんでした"], ko: ["복사됨", "복사 실패"] };
  const [copied, failed] = COPIED[document.documentElement.lang] ?? ["Copied", "Copy failed"];
  // the buttons' aria-labels hide their changed text from a screen reader, so the result is also said here
  const status = document.createElement("p");
  status.className = "visually-hidden";
  status.setAttribute("role", "status");
  document.body.append(status);
  for (const button of document.querySelectorAll("button[data-copy]")) {
    const label = button.textContent;
    let timer;
    button.addEventListener("click", async () => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        ok = true;
      } catch {
        // no async clipboard (plain http, an older browser): copy from a hidden text field
        const field = document.createElement("textarea");
        field.value = button.dataset.copy;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.append(field);
        field.select();
        ok = document.execCommand("copy");
        field.remove();
      }
      button.textContent = status.textContent = ok ? copied : failed;
      clearTimeout(timer);
      timer = setTimeout(() => { button.textContent = label; status.textContent = ""; }, 2000);
    });
  }

  // the language picker opens this page in the chosen language; back from there, it shows this one again
  for (const select of document.querySelectorAll("select[data-beta-lang]")) {
    select.addEventListener("change", () => { location.href = select.value; });
    addEventListener("pageshow", () => { for (const option of select.options) option.selected = option.defaultSelected; });
  }
})();
