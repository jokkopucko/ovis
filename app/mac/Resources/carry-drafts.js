// Ovis for Mac writes this into the page at a new address (another port is another origin, with
// storage of its own) before the page's code starts: the unsent drafts read from the page the window
// left (WebPage.swift). Nothing here sends anything; a draft waits in the page for Send or Discard.
function ovisCarryDrafts(storage, carried, shared, token, loaded, given, post) {
  const MARK = "ovis-mac:carried";
  let mark = null;
  try {
    mark = JSON.parse(storage.getItem(MARK) ?? "null");
  } catch {
  }
  const again = mark !== null && typeof mark === "object" && mark.token === token && Array.isArray(mark.done)
    && mark.before !== null && typeof mark.before === "object";
  const landed = new Set(again ? mark.done : []);
  const before = again ? mark.before : given ?? {};
  const save = () => {
    try {
      storage.setItem(MARK, JSON.stringify({ token, done: [...landed], before }));
      return true;
    } catch {
      return false;
    }
  };
  if (!again) {
    if (!given && !loaded) {
      try {
        for (const key of Object.keys(carried)) before[key] = storage.getItem(key);
      } catch {
        return;
      }
      try {
        post?.({ token, before });
      } catch {
      }
    }
    // the mark first, with every baseline: a draft written without one could be written again over typing
    if (!save()) return;
    if (!loaded && !shared) {
      try {
        const leases = [];
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key && key.startsWith("ovis:composer-sending:") && !Object.hasOwn(carried, key)) leases.push(key);
        }
        for (const key of leases) storage.removeItem(key);
      } catch {
      }
    }
  }
  for (const [key, value] of Object.entries(carried)) {
    if (landed.has(key)) continue;
    try {
      const now = storage.getItem(key);
      const pagesOwn = shared || !Object.hasOwn(before, key) ? now !== null : now !== before[key];
      if (!pagesOwn) storage.setItem(key, value);
      landed.add(key);
      save();
    } catch {
    }
  }
}
