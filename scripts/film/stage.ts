/**
 * - Objects: the browser window and the phone of DESIGN.md/brief section 2, each carrying a recorded
 *   frame. The frame is resampled once in a canvas at the size it takes on screen (Skia's high
 *   quality downscale), and only then moved by the object's matrix3d (perspective, rotation,
 *   translation, near unit scale), so UI text stays crisp and never shimmers under a slow push.
 */

export interface ObjDesc {
  id: string;
  kind: "window" | "phone";
  src: string;
  vp: { w: number; h: number };
  dpr: number;
  k: number;
  u: number;
  m: number[];
  opacity: number;
  dim: number;
  cursor: { x: number; y: number; a: number; press: number } | null;
  rings: { x: number; y: number; age: number }[];
  touches: { x: number; y: number; age: number }[];
}

export interface TypeDesc {
  id: string;
  role: "primary" | "secondary" | "centered";
  text: string;
  x: number;
  y: number;
  align: "left" | "center" | "right";
  tIn: number;
  tOut: number;
  cut?: boolean;
  rail?: boolean;
  delays?: number[];
  shade?: boolean;
  shadeTop?: number;
  shadeRight?: number;
  shadeCol?: boolean;
}

export interface FrameDesc {
  t: number;
  fade: number;
  reveal: number | null;
  lamp: number;
  pools: { x: number; y: number; w: number; h: number; a: number }[];
  objs: ObjDesc[];
  scrim: { left: number; bottom: number };
  type: TypeDesc[];
  keys: { t0: number; labels: string[]; press: number[]; tOut: number } | null;
  end: { t0: number } | null;
  vignette: number;
  falloff?: number;
}

export const STAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Pretendard Variable"; src: url("/_film/fonts/PretendardVariable.ttf") format("truetype"); font-weight: 45 920; }
@font-face { font-family: "JetBrains Mono"; src: url("/_film/fonts/JetBrainsMono-Regular.ttf") format("truetype"); font-weight: 400; }
@font-face { font-family: "JetBrains Mono"; src: url("/_film/fonts/JetBrainsMono-Medium.ttf") format("truetype"); font-weight: 500; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 1920px; height: 1080px; overflow: hidden; background: #12100e; }
body { font-family: "Pretendard Variable", sans-serif; -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
#stage { position: absolute; inset: 0; overflow: hidden; background: #12100e; }
#lamp { position: absolute; inset: 0; background: radial-gradient(ellipse 60% 55% at 50% -8%, rgba(240,168,48,0.10), rgba(240,168,48,0.03) 40%, transparent 70%); }
#pools, #objs, #type, #end, #shade { position: absolute; inset: 0; }
#lamp { z-index: 0; } #pools { z-index: 1; } #objs { z-index: 2; isolation: isolate; } #scrimL, #scrimB, #shade { z-index: 3; } #vig { z-index: 4; } #type, #keys { z-index: 5; } #end { z-index: 6; } #reveal { z-index: 7; } #fade { z-index: 8; }
.pool { position: absolute; border-radius: 50%; background: radial-gradient(closest-side, rgba(242,235,223,0.06), rgba(242,235,223,0.025) 55%, transparent); }
.obj { position: absolute; left: 0; top: 0; transform-origin: 0 0; backface-visibility: hidden; }
.body { position: absolute; inset: 0; overflow: hidden; }
.win .body { background: #181613; border: 1px solid rgba(242,235,223,0.09); }
.bar { position: absolute; left: 0; right: 0; top: 0; background: #181613; }
.bar i { position: absolute; border-radius: 50%; background: #3e3830; }
.pill { position: absolute; left: 50%; transform: translateX(-50%); display: flex; align-items: center; justify-content: center;
  font-family: "JetBrains Mono", monospace; font-weight: 400; color: #9b9183; background: #12100e; white-space: nowrap; }
.screen { position: absolute; overflow: hidden; background: #12100e; }
.screen canvas { position: absolute; left: 0; top: 0; }
.falloff { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 35%, rgba(0,0,0,0.14) 100%); }
.spec { position: absolute; left: 0; right: 0; top: 0; height: 1px; background: rgba(255,240,220,0.14); }
.dim { position: absolute; inset: 0; background: #000; }
.phone .body { background: #0b0a09; box-shadow: 0 0 0 1px rgba(242,235,223,0.10); }
.hand { position: absolute; left: 0; top: 0; width: 0; height: 0; overflow: visible; }
.cur { position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; background: rgba(242,235,223,0.85); box-shadow: 0 0 0 1px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.35); }
.ring { position: absolute; border-radius: 50%; border: 2px solid #f0a830; }
.touch { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; background: rgba(255,255,255,0.25); }
#scrimL { position: absolute; inset: 0; background: linear-gradient(to right, rgba(18,16,14,0.78) 0%, rgba(18,16,14,0.74) 24%, rgba(18,16,14,0.42) 36%, rgba(18,16,14,0) 47%); }
#scrimB { position: absolute; inset: 0; background: linear-gradient(to top, rgba(18,16,14,0.8) 0%, rgba(18,16,14,0.5) 16%, rgba(18,16,14,0) 34%); }
#vig { position: absolute; inset: 0; background: radial-gradient(ellipse 75% 75% at 50% 48%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.18) 100%); }
#fade { position: absolute; inset: 0; background: #000; }
#reveal { position: absolute; inset: 0; }
.line { position: absolute; white-space: nowrap; }
.line .w { display: inline-block; overflow: hidden; vertical-align: top; }
.line .w > span { display: inline-block; }
.primary, .centered { text-shadow: 0 2px 28px rgba(12,10,8,0.7); }
.secondary { text-shadow: 0 1px 14px rgba(12,10,8,0.9); }
.primary { font-family: "Pretendard Variable"; font-weight: 780; font-size: 88px; line-height: 1.12; letter-spacing: -0.04em; color: #f2ebdf; font-variation-settings: "wght" 780; }
.centered { font-family: "Pretendard Variable"; font-weight: 760; font-size: 64px; line-height: 1.14; letter-spacing: -0.035em; color: #f2ebdf; }
.secondary { font-family: "JetBrains Mono"; font-weight: 500; font-size: 26px; line-height: 1.4; color: #9b9183; letter-spacing: 0; }
.shade { position: absolute; background: #12100e; pointer-events: none; }
.rail { position: absolute; width: 3px; background: #f0a830; transform-origin: 50% 0; }
#keys { position: absolute; left: 0; right: 0; bottom: 26px; display: flex; justify-content: center; gap: 14px; }
.kbd { font-family: "JetBrains Mono"; font-weight: 500; font-size: 28px; line-height: 1; color: #d8d0c3; background: #211e1a; border: 1px solid #2d2924;
  border-bottom: 2px solid #3e3830; border-radius: 6px; padding: 16px 22px 14px; min-width: 64px; text-align: center; box-shadow: 0 18px 40px -12px rgba(0,0,0,0.7); }
#end { display: none; }
#end .col { position: absolute; left: 0; right: 0; top: 0; bottom: 0; }
#end img { position: absolute; left: 50%; width: 150px; height: 150px; margin-left: -75px; top: 206px; }
#end .word { position: absolute; left: 0; right: 0; top: 380px; text-align: center; font-weight: 700; font-size: 64px; letter-spacing: -0.03em; color: #f2ebdf; line-height: 1; }
#end .cmd { position: absolute; left: 50%; top: 612px; font-family: "JetBrains Mono"; font-weight: 400; font-size: 24px; line-height: 1; color: #d8d0c3; white-space: pre; }
#end .cmd b { color: #f0a830; font-weight: 400; }
#end .cmd .blk { display: inline-block; width: 0.6em; height: 1.08em; background: #f0a830; vertical-align: -0.2em; margin-left: 2px; }
#end .tag { position: absolute; left: 0; right: 0; top: 474px; text-align: center; font-weight: 560; font-size: 40px; letter-spacing: -0.018em; color: #d8d0c3; line-height: 1.2; }
#end .url { position: absolute; left: 0; right: 0; top: 700px; text-align: center; font-family: "JetBrains Mono"; font-weight: 400; font-size: 18px; color: #6f675c; line-height: 1; }
</style></head><body>
<div id="stage"><div id="lamp"></div><div id="pools"></div><div id="objs"></div>
<div id="scrimL"></div><div id="scrimB"></div><div id="shade"></div><div id="vig"></div>
<div id="type"></div><div id="keys"></div>
<div id="end"><img src="/_film/brand/mark-paper.png"><div class="word">Ovis</div><div class="cmd"></div><div class="tag">Your agents, in plain conversation.</div><div class="url">ovis.sh · MIT · a plugin for herdr</div></div>
<div id="reveal"></div><div id="fade"></div></div>
<script>
const $ = (id) => document.getElementById(id);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
// cubic-bezier(0.2, 0, 0, 1), the one easing
function bez(x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const ax = 0.2, bx = 0, cy1 = 0, cy2 = 1;
  const X = (u) => 3 * (1 - u) * (1 - u) * u * ax + 3 * (1 - u) * u * u * bx + u * u * u;
  const Y = (u) => 3 * (1 - u) * (1 - u) * u * cy1 + 3 * (1 - u) * u * u * cy2 + u * u * u;
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (X(m) < x) lo = m; else hi = m; }
  return Y((lo + hi) / 2);
}
const bitmaps = new Map();
async function bitmap(url) {
  let b = bitmaps.get(url);
  if (!b) {
    b = createImageBitmap(await (await fetch(url)).blob());
    bitmaps.set(url, b);
    if (bitmaps.size > 48) { const first = bitmaps.keys().next().value; const old = bitmaps.get(first); bitmaps.delete(first); old.then((x) => x.close()).catch(() => {}); }
  }
  return b;
}
const objEls = new Map();
function makeObj(d) {
  const el = document.createElement("div");
  el.className = "obj " + (d.kind === "window" ? "win" : "phone");
  const body = document.createElement("div"); body.className = "body";
  const screen = document.createElement("div"); screen.className = "screen";
  const canvas = document.createElement("canvas");
  const falloff = document.createElement("div"); falloff.className = "falloff";
  const dim = document.createElement("div"); dim.className = "dim";
  screen.append(canvas, falloff);
  let bar = null, pill = null, dots = [];
  if (d.kind === "window") {
    bar = document.createElement("div"); bar.className = "bar";
    for (let i = 0; i < 3; i++) { const dot = document.createElement("i"); bar.append(dot); dots.push(dot); }
    pill = document.createElement("div"); pill.className = "pill"; pill.textContent = "localhost:7317"; bar.append(pill);
    body.append(bar, screen);
  } else body.append(screen);
  const spec = document.createElement("div"); spec.className = "spec";
  body.append(spec, dim);
  const hand = document.createElement("div"); hand.className = "hand";
  el.append(body, hand);
  $("objs").append(el);
  const o = { el, body, screen, canvas, g: canvas.getContext("2d"), bar, pill, dots, dim, hand, src: null, cw: 0, ch: 0 };
  objEls.set(d.id, o);
  return o;
}
function layoutObj(o, d) {
  const u = d.u, k = d.k;
  const sw = d.vp.w * k, sh = d.vp.h * k;
  let W, H, sx, sy, r, rs;
  if (d.kind === "window") {
    const bar = 38 * u;
    W = sw; H = sh + bar; sx = 0; sy = bar; r = 14 * u; rs = 0;
    o.bar.style.height = bar + "px";
    o.dots.forEach((dot, i) => { dot.style.width = dot.style.height = 12 * u + "px"; dot.style.left = (18 + i * 20) * u + "px"; dot.style.top = (bar - 12 * u) / 2 + "px"; });
    o.pill.style.height = 24 * u + "px"; o.pill.style.top = 7 * u + "px"; o.pill.style.fontSize = 12 * u + "px";
    o.pill.style.padding = "0 " + 60 * u + "px"; o.pill.style.borderRadius = 7 * u + "px";
    o.body.style.boxShadow = "0 " + 50 * u + "px " + 120 * u + "px " + (-20 * u) + "px rgba(0,0,0,0.7), 0 0 0 1px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,240,220,0.14)";
    o.screen.style.borderRadius = "0 0 " + r + "px " + r + "px";
  } else {
    const b = 10 * u;
    W = sw + 2 * b; H = sh + 2 * b; sx = b; sy = b; r = 46 * u; rs = 36 * u;
    o.body.style.boxShadow = "0 0 0 1px rgba(242,235,223,0.10), 0 " + 40 * u + "px " + 60 * u + "px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,240,220,0.10)";
    o.screen.style.borderRadius = rs + "px";
  }
  o.el.style.width = W + "px"; o.el.style.height = H + "px";
  o.body.style.borderRadius = r + "px";
  Object.assign(o.screen.style, { left: sx + "px", top: sy + "px", width: sw + "px", height: sh + "px" });
  o.hand.style.left = sx + "px"; o.hand.style.top = sy + "px";
  // the canvas holds the frame at exactly its on-screen pixel size
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.ceil(sw * dpr), ch = Math.ceil(sh * dpr);
  if (cw !== o.cw || ch !== o.ch) { o.canvas.width = cw; o.canvas.height = ch; o.cw = cw; o.ch = ch; }
  o.canvas.style.width = cw / dpr + "px"; o.canvas.style.height = ch / dpr + "px";
  return { sw, sh, dpr };
}
async function drawObj(d) {
  const o = objEls.get(d.id) || makeObj(d);
  o.el.style.display = "";
  const { sw, sh, dpr } = layoutObj(o, d);
  const bmp = await bitmap(d.src);
  o.g.imageSmoothingEnabled = true; o.g.imageSmoothingQuality = "high";
  o.g.clearRect(0, 0, o.cw, o.ch);
  o.g.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, sw * dpr, sh * dpr);
  o.el.style.transform = "matrix3d(" + d.m.join(",") + ")";
  o.el.style.opacity = d.opacity;
  o.dim.style.opacity = d.dim;
  // the hand, on the screen, in output px
  o.hand.textContent = "";
  const k = d.k;
  for (const t of d.touches) {
    const p = clamp(t.age / 0.42);
    const e = document.createElement("div"); e.className = "touch";
    Object.assign(e.style, { left: t.x * k + "px", top: t.y * k + "px", opacity: String(1 - bez(p)) });
    o.hand.append(e);
  }
  for (const r of [...d.rings, ...d.touches]) {
    const p = clamp(r.age / 0.42), rad = 8 + 20 * bez(p);
    const e = document.createElement("div"); e.className = "ring";
    Object.assign(e.style, { left: r.x * k - rad + "px", top: r.y * k - rad + "px", width: 2 * rad + "px", height: 2 * rad + "px", opacity: String(1 - p) });
    o.hand.append(e);
  }
  if (d.cursor && d.cursor.a > 0) {
    const e = document.createElement("div"); e.className = "cur";
    Object.assign(e.style, { left: d.cursor.x * k + "px", top: d.cursor.y * k + "px", opacity: String(d.cursor.a), transform: "scale(" + d.cursor.press + ")" });
    o.hand.append(e);
  }
}
// ---- type ----
const lineEls = new Map();
function makeLine(d) {
  const el = document.createElement("div");
  el.className = "line " + d.role;
  const spans = [];
  d.text.split("|").forEach((row, r) => {
    if (r > 0) el.append(document.createElement("br"));
    const words = row.split(" ");
    words.forEach((w, i) => {
      const outer = document.createElement("span"); outer.className = "w";
      const inner = document.createElement("span"); inner.textContent = w;
      outer.append(inner); el.append(outer);
      if (i < words.length - 1) el.append(document.createTextNode(" "));
      spans.push(inner);
    });
  });
  let rail = null;
  const shade = document.createElement("div"); shade.className = "shade"; $("shade").append(shade);
  if (d.rail) { rail = document.createElement("div"); rail.className = "rail"; $("type").append(rail); }
  $("type").append(el);
  const rec = { el, spans, rail, shade, w: 0 };
  lineEls.set(d.id, rec);
  return rec;
}
function drawType(list, t) {
  const live = new Set();
  for (const d of list) {
    // the shade arrives 0.25 s before the words and leaves 0.2 s after them
    if (t < d.tIn - (d.shade ? 0.25 : 0) || t >= d.tOut + (d.shade ? 0.2 : 0)) continue;
    live.add(d.id);
    const L = lineEls.get(d.id) || makeLine(d);
    L.el.style.display = ""; if (L.rail) L.rail.style.display = "";
    const local = t - d.tIn;
    const exitP = d.cut ? (t >= d.tOut ? 1 : 0) : clamp((t - (d.tOut - 0.24)) / 0.24);
    const ex = bez(exitP);
    let x = d.x;
    if (d.align === "center") { const w = L.el.offsetWidth; x = d.x - w / 2; }
    if (d.align === "right") x = d.x - L.el.offsetWidth;
    L.el.style.left = x + "px"; L.el.style.top = d.y + "px";
    L.el.style.opacity = String(local < 0 ? 0 : 1 - ex);
    L.el.style.transform = "translateY(" + (-12 * ex) + "px)";
    if (d.role === "secondary") {
      const p = bez(clamp(local / 0.3));
      L.el.style.opacity = String(p * (1 - ex));
      L.el.style.transform = "translateY(" + ((1 - p) * 6 - 12 * ex) + "px)";
    } else {
      L.spans.forEach((s, i) => {
        const p = bez(clamp((local - (d.delays ? d.delays[i] : i * 0.07)) / 0.42));
        s.style.transform = "translateY(" + (1 - p) * 28 + "px)";
        s.style.opacity = String(clamp(p * 3));
      });
    }
    if (d.shade) {
      // primary: a feathered column from the frame's left edge past the words; secondary: a feathered patch
      const w = L.el.offsetWidth, h = L.el.offsetHeight;
      const up = bez(clamp((t - (d.tIn - 0.25)) / 0.3)), down = bez(clamp((d.tOut + 0.2 - t) / 0.35));
      const col = d.role !== "secondary" || !!d.shadeCol;
      const box = col
        ? { left: -240, top: d.y - (d.shadeTop ?? 200), width: x + w + (d.shadeRight ?? 100) + 240, height: h + 90 + (d.shadeTop ?? 200), blur: 64, a: 0.94 }
        : { left: x - 110, top: d.y - 60, width: w + 220, height: h + 120, blur: 40, a: 0.93 };
      Object.assign(L.shade.style, { display: "", left: box.left + "px", top: box.top + "px", width: box.width + "px", height: box.height + "px",
        filter: "blur(" + box.blur + "px)", borderRadius: col ? "0" : "28px", opacity: String(box.a * Math.min(up, down)) });
    } else L.shade.style.display = "none";
    if (L.rail) {
      const h = L.el.offsetHeight;
      const lastIn = d.delays ? Math.max(...d.delays) : 0.07 * (L.spans.length - 1);
      const grow = bez(clamp(local / (0.42 + lastIn)));
      const lh = h / Math.max(1, d.text.split("|").length);
      Object.assign(L.rail.style, { left: x - 28 + "px", top: d.y + lh * 0.2 + "px", height: h - lh * 0.34 + "px", transform: "scaleY(" + grow + ") translateY(" + (-12 * ex) + "px)", opacity: String(local < 0 ? 0 : 1 - ex) });
    }
  }
  for (const [id, L] of lineEls) if (!live.has(id)) { L.el.style.display = "none"; L.shade.style.display = "none"; if (L.rail) L.rail.style.display = "none"; }
}
function drawKeys(k, t) {
  const box = $("keys");
  if (!k || t < k.t0 || t >= k.tOut) { box.style.display = "none"; return; }
  box.style.display = "flex";
  if (box.childElementCount !== k.labels.length) { box.textContent = ""; for (const l of k.labels) { const e = document.createElement("div"); e.className = "kbd"; e.textContent = l; box.append(e); } }
  const inP = bez(clamp((t - k.t0) / 0.18)), outP = bez(clamp((t - (k.tOut - 0.24)) / 0.24));
  box.style.opacity = String(inP * (1 - outP));
  box.style.transform = "translateY(" + ((1 - inP) * 10 - outP * 8) + "px)";
  [...box.children].forEach((e, i) => {
    const since = t - k.press[i];
    const down = since >= 0;
    e.style.transform = down ? "translateY(2px)" : "none";
    e.style.borderBottomWidth = down ? "1px" : "2px";
    e.style.color = down ? "#f2ebdf" : "#d8d0c3";
    e.style.boxShadow = down ? "0 0 0 1px rgba(240,168,48,0.55), 0 14px 32px -12px rgba(0,0,0,0.7)" : "0 18px 40px -12px rgba(0,0,0,0.7)";
  });
}
const CMD = "curl -fsSL https://ovis.sh/install.sh | sh";
function drawEnd(e, t) {
  const root = $("end");
  if (!e) { root.style.display = "none"; return; }
  root.style.display = "block";
  const l = t - e.t0;
  const img = root.querySelector("img");
  const m = bez(clamp(l / 0.6));
  img.style.opacity = String(m); img.style.transform = "translateY(" + (1 - m) * 12 + "px)";
  const w = root.querySelector(".word"), wp = bez(clamp((l - 0.4) / 0.6));
  w.style.opacity = String(wp); w.style.transform = "translateY(" + (1 - wp) * 12 + "px)";
  const cmd = root.querySelector(".cmd");
  const n = clamp(Math.floor((l - 1.5) / 0.022), 0, CMD.length);
  const beat = 0.8, blinkOn = l < 3.2 || ((t % beat) / beat) < 0.5;
  cmd.style.display = l >= 1.4 ? "" : "none";
  cmd.innerHTML = '<b>$</b> ' + CMD.slice(0, n).replace(/&/g, "&amp;").replace(/</g, "&lt;") + '<span class="blk" style="opacity:' + (blinkOn ? 1 : 0) + '"></span>';
  // centre on the full command so the line does not creep as it types
  if (!Number(cmd.dataset.w)) {
    const full = cmd.innerHTML, shown = cmd.style.display;
    cmd.style.display = ""; cmd.innerHTML = '<b>$</b> ' + CMD + '<span class="blk"></span>';
    const w = cmd.offsetWidth; if (w > 0) cmd.dataset.w = String(w);
    cmd.innerHTML = full; cmd.style.display = shown;
  }
  cmd.style.marginLeft = -Number(cmd.dataset.w) / 2 + "px";
  // the thesis holds longest: in before the install line types on
  const tag = root.querySelector(".tag"), tp = bez(clamp((l - 0.9) / 0.6));
  tag.style.opacity = String(tp); tag.style.transform = "translateY(" + (1 - tp) * 10 + "px)";
  const url = root.querySelector(".url"), up = bez(clamp((l - 3.2) / 0.5));
  url.style.opacity = String(up);
}
window.film = {
  async draw(f) {
    $("lamp").style.opacity = String(f.lamp);
    $("fade").style.opacity = String(f.fade);
    $("vig").style.opacity = String(f.vignette);
    document.querySelectorAll(".falloff").forEach((e) => (e.style.opacity = String(f.falloff ?? 1)));
    if (f.reveal === null) $("reveal").style.display = "none";
    else {
      const p = f.reveal, a0 = clamp(1 - p * 1.45), a1 = clamp(1 - p * 0.95), a2 = clamp(1 - p);
      $("reveal").style.display = "";
      $("reveal").style.background = "radial-gradient(ellipse 85% 95% at 50% 8%, rgba(0,0,0," + a0 + ") 0%, rgba(0,0,0," + a1 + ") 55%, rgba(0,0,0," + a2 + ") 100%)";
    }
    const pools = $("pools"); pools.textContent = "";
    for (const p of f.pools) { const e = document.createElement("div"); e.className = "pool"; Object.assign(e.style, { left: p.x - p.w / 2 + "px", top: p.y - p.h / 2 + "px", width: p.w + "px", height: p.h + "px", opacity: String(p.a) }); pools.append(e); }
    const ids = new Set(f.objs.map((o) => o.id));
    for (const [id, o] of objEls) if (!ids.has(id)) o.el.style.display = "none";
    await Promise.all(f.objs.map(drawObj));
    f.objs.forEach((o, i) => { objEls.get(o.id).el.style.zIndex = String(i + 1); });
    $("scrimL").style.opacity = String(f.scrim.left);
    $("scrimB").style.opacity = String(f.scrim.bottom);
    drawType(f.type, f.t);
    drawKeys(f.keys, f.t);
    drawEnd(f.end, f.t);
    await new Promise((r) => requestAnimationFrame(() => r()));
  },
};
window.filmReady = document.fonts.ready.then(() => Promise.all([...document.fonts].map((f) => f.load()))).then(() => document.querySelector("#end img").decode()).then(() => true);
</script></body></html>`;
