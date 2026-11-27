// Ovis for Mac runs this in its main window's page as each page commits (TitleBar.swift): the window
// draws no title bar there, and the page takes its place. `height` is the bar's height and `inset` the
// traffic lights' right edge, as AppKit laid them out. The page marks the lights' corner as an iPad
// window's (`data-window-controls`, lib/viewport.ts), so each screen keeps clear of it, and the wide
// header takes the bar's height (`[data-mac-title-bar]` in src/styles.css). A press off the page's
// controls, on a top bar or within the bar's height of the window's top, asks the app to move the
// window once the mouse moves (`drag`, with where the press was, so the app moves the window for that
// press only), and a double click there does what a title bar's does (`zoom`). A window the page
// opened keeps its title bar and runs none of this.
function ovisTitleBar(document, height, inset, post) {
  const root = document.documentElement;
  // once per page: the app runs it as the page commits and again once the window's bar is folded
  if (!root || root.dataset.macTitleBar !== undefined) return;
  root.dataset.macTitleBar = "";
  root.dataset.windowControls = "";
  root.style.setProperty("--mac-title-bar-h", `${height}px`);
  root.style.setProperty("--mac-title-bar-inset", `${inset}px`);

  // the bars an installed desktop app drags its window by (styles.css, InboxMode.css)
  const BARS = ["app-header", "inbox-top", "thread-top"];
  const CONTROLS = "button, a, input, select, textarea, label, summary, [contenteditable], [role=button], [role=link], [role=tab], [role=group], [role=menu], [role=menuitem], [role=dialog], [role=listbox], [role=option]";
  // walked up to a bar, or to the page: a control, an open modal scrim or an open menu on the way
  // keeps the press the page's; a container focused only by script (tabindex -1, as .app is) and the
  // header's pane title text (role=group for accessibility) do not
  // the inbox's thread bar lets presses through to its pane (InboxMode.css), so the walk below never meets it: a
  // press in its box on what lies under it is the bar's, as on the installed desktop app's drag region
  const throughBar = (event) => Array.from(document.querySelectorAll(".thread-top")).some((bar) => {
    if (bar.contains(event.target) || !bar.parentElement?.contains(event.target)) return false;
    const box = bar.getBoundingClientRect();
    return event.clientX >= box.left && event.clientX < box.right && event.clientY >= box.top && event.clientY < box.bottom;
  });
  const bare = (event) => {
    if (throughBar(event)) return true;
    for (let node = event.target; node && typeof node.matches === "function"; node = node.parentElement) {
      if (node.classList.contains("modal-scrim")) return false;
      if ((node.matches(CONTROLS) && !node.classList.contains("context-title-text")) || node.tabIndex >= 0) return false;
      if (BARS.some((name) => node.classList.contains(name))) return true;
    }
    return event.clientY < height;
  };
  document.addEventListener("mousedown", (event) => {
    if (event.button === 0 && event.detail === 1 && bare(event)) post({ ask: "drag", x: event.clientX, y: event.clientY });
  }, true);
  document.addEventListener("dblclick", (event) => {
    if (event.button === 0 && bare(event)) post({ ask: "zoom" });
  }, true);
}
